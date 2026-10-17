"""Deploy the durable PDF worker without logging application credentials."""
import argparse
import json
import os
import re
import subprocess
import tempfile

ENV_ALLOWLIST = {
    'STORAGE_MODE', 'MONGO_DB', 'MONGO_URL', 'OBJECT_STORAGE_PROVIDER',
    'GOOGLE_DRIVE_FOLDER_ID', 'BUILDER_PROJECTS_DRIVE_FOLDER_ID',
    'SIG_REALTY_GOOGLE_CLIENT_ID', 'SIG_REALTY_GOOGLE_CLIENT_SECRET',
    'SIG_REALTY_GOOGLE_REFRESH_TOKEN', 'GEMINI_API_KEY', 'GEMINI_BROCHURE_MODEL',
    'GEMINI_AGENT_MODEL', 'GEMINI_BROCHURE_FALLBACK_MODEL',
    'MONGO_SOCKET_TIMEOUT_MS', 'MONGO_CONNECT_TIMEOUT_MS',
    'MONGO_SERVER_SELECTION_TIMEOUT_MS', 'MONGO_POLL_INTERVAL_MS',
}
JOB = 'residential-brochure-worker'


def job_manifest(service, image, project, region):
    template = service['spec']['template']
    source = template['spec']
    env = [v for v in source['containers'][0].get('env', []) if v['name'] in ENV_ALLOWLIST]
    names = {v['name'] for v in env}
    if not {'MONGO_URL', 'GEMINI_API_KEY', 'GOOGLE_DRIVE_FOLDER_ID'}.issubset(names):
        raise ValueError('Required durable storage / AI / Drive configuration is missing')
    if not source.get('serviceAccountName'):
        raise ValueError('Explicit existing runtime service account required')
    annotations = {k: v for k, v in template.get('metadata', {}).get('annotations', {}).items()
                   if k in {'run.googleapis.com/cloudsql-instances', 'run.googleapis.com/vpc-access-connector',
                            'run.googleapis.com/vpc-access-egress', 'run.googleapis.com/network-interfaces',
                            'run.googleapis.com/secrets'}}
    return {'apiVersion': 'run.googleapis.com/v1', 'kind': 'Job',
            'metadata': {'name': JOB, 'namespace': project, 'labels': {'cloud.googleapis.com/location': region}},
            'spec': {'template': {'metadata': {'annotations': annotations}, 'spec': {
                'parallelism': 1, 'taskCount': 1, 'template': {'spec': {
                    'serviceAccountName': source['serviceAccountName'], 'maxRetries': 0, 'timeoutSeconds': '7200',
                    'containers': [{'image': image, 'command': ['node'],
                                    'args': ['scripts/residentialBrochureWorker.js', '--apply'],
                                    'env': env, 'resources': {'limits': {'cpu': '1', 'memory': '1Gi'}}}]}}}}}}


def run(args, **kwargs):
    # Capturing output prevents a failed CLI call from echoing env/secret values.
    print('WORKER_SETUP_STEP=' + ' '.join(args[:3]), flush=True)
    try:
        result = subprocess.run(['gcloud', *args], capture_output=True, text=True, timeout=kwargs.pop('timeout', 180), **kwargs)
    except subprocess.TimeoutExpired:
        raise RuntimeError('Cloud setup timed out at ' + ' '.join(args[:3]) + '; inspect worker execution logs') from None
    if result.returncode:
        # Only the command family is safe to print; the private manifest is removed.
        reason = re.search(r"Permission '[a-zA-Z0-9_.]+' denied|PERMISSION_DENIED|SERVICE_DISABLED|INVALID_ARGUMENT", result.stderr or '')
        raise RuntimeError('Cloud setup failed at ' + ' '.join(args[:3]) + ': ' + (reason.group(0) if reason else 'inspect Cloud audit logs'))
    return result.stdout


def main():
    parser = argparse.ArgumentParser()
    for name in ['image', 'project', 'region', 'service']:
        parser.add_argument('--' + name, required=True)
    args = parser.parse_args()
    common = ['--project=' + args.project, '--region=' + args.region, '--quiet']
    service = json.loads(run(['run', 'services', 'describe', args.service, *common, '--format=json']))
    manifest = job_manifest(service, args.image, args.project, args.region)
    account = manifest['spec']['template']['spec']['template']['spec']['serviceAccountName']
    fd, path = tempfile.mkstemp(suffix='.json')
    try:
        with os.fdopen(fd, 'w') as output:
            json.dump(manifest, output)
        run(['run', 'jobs', 'replace', path, *common])
    finally:
        os.unlink(path)
    # API activation is a one-time project-admin operation, not a deployment
    # permission. Do not require serviceusage.services.enable on every build.
    # Bootstrap once: gcloud services enable cloudscheduler.googleapis.com --project=PROJECT
    location = ['--project=' + args.project, '--location=' + args.region, '--quiet']
    existing = json.loads(run(['scheduler', 'jobs', 'list', *location, '--format=json']))
    operation = 'update' if any(job['name'].endswith('/' + JOB) for job in existing) else 'create'
    run(['scheduler', 'jobs', operation, 'http', JOB, *location,
         '--schedule=*/15 * * * *', '--time-zone=Asia/Kolkata', '--http-method=POST',
         '--uri=https://run.googleapis.com/v2/projects/' + args.project + '/locations/' + args.region + '/jobs/' + JOB + ':run',
         '--oauth-service-account-email=' + account, '--oauth-token-scope=https://www.googleapis.com/auth/cloud-platform',
         '--message-body={}', '--max-retry-attempts=0'])
    # Verify container boot and Mongo connectivity without consuming AI quota.
    run(['run', 'jobs', 'execute', JOB, *common, '--args=scripts/residentialBrochureWorker.js,--check-storage', '--task-timeout=600s', '--wait'], timeout=660)
    print('RESIDENTIAL_WORKER_DEPLOYED: storage check passed; scheduler configured every 15 minutes')


if __name__ == '__main__':
    main()
