"""Deployment must not require project-wide API activation privileges."""
import importlib.util
import json
import pathlib
import unittest
import subprocess
from unittest.mock import patch

PATH = pathlib.Path(__file__).resolve().parents[1] / 'scripts' / 'deployResidentialWorker.py'
SPEC = importlib.util.spec_from_file_location('deploy_residential_worker', PATH)
deploy = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(deploy)


class WorkerDeploymentTest(unittest.TestCase):
    def test_storage_timeout_configuration_is_inherited_without_login_secrets(self):
        env = [{'name': key, 'value': value} for key, value in {
            'MONGO_URL':'fixture', 'GEMINI_API_KEY':'fixture', 'GOOGLE_DRIVE_FOLDER_ID':'fixture',
            'MONGO_SOCKET_TIMEOUT_MS':'90000', 'APP_PIN':'private-fixture'
        }.items()]
        service = {'spec':{'template':{'spec':{'serviceAccountName':'existing@project.iam.gserviceaccount.com',
                                             'containers':[{'env':env}]}}}}
        job = deploy.job_manifest(service, 'image', 'project', 'asia-south1')
        copied = job['spec']['template']['spec']['template']['spec']['containers'][0]['env']
        self.assertIn({'name':'MONGO_SOCKET_TIMEOUT_MS','value':'90000'}, copied)
        self.assertNotIn('APP_PIN', {row['name'] for row in copied})

    def test_cli_timeout_reports_only_safe_command_family(self):
        with patch.object(deploy.subprocess, 'run', side_effect=subprocess.TimeoutExpired('private-fixture', 660)) as call:
            with self.assertRaisesRegex(RuntimeError, 'timed out at run jobs execute') as error:
                deploy.run(['run','jobs','execute','worker'], timeout=660)
            self.assertNotIn('private-fixture', str(error.exception))
            self.assertEqual(call.call_args.kwargs['timeout'], 660)

    def test_deploy_uses_existing_api_without_service_enable(self):
        calls = []
        service = {'spec': {'template': {'spec': {
            'serviceAccountName': 'existing@project.iam.gserviceaccount.com',
            'containers': [{'env': [{'name': name, 'value': 'fixture'} for name in
                                   ['MONGO_URL', 'GEMINI_API_KEY', 'GOOGLE_DRIVE_FOLDER_ID']]}]}}}}

        def run(args, **_kwargs):
            calls.append(args)
            self.assertNotEqual(args[:2], ['services', 'enable'])
            if args[:3] == ['run', 'services', 'describe']:
                return json.dumps(service)
            if args[:3] == ['scheduler', 'jobs', 'list']:
                return '[]'
            return ''

        with patch.object(deploy, 'run', side_effect=run), patch('sys.argv', [
            str(PATH), '--image=image', '--project=project', '--region=asia-south1', '--service=crm'
        ]):
            deploy.main()
        self.assertTrue(any(args[:3] == ['run', 'jobs', 'replace'] for args in calls))
        self.assertTrue(any(args[:4] == ['scheduler', 'jobs', 'create', 'http'] for args in calls))
        self.assertIn('--wait', calls[-1])
        self.assertIn('--task-timeout=600s', calls[-1])
        self.assertIn('--args=scripts/residentialBrochureWorker.js,--check-storage', calls[-1])


if __name__ == '__main__':
    unittest.main()
