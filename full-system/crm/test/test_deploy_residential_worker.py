"""Deployment must not require project-wide API activation privileges."""
import importlib.util
import json
import pathlib
import unittest
from unittest.mock import patch

PATH = pathlib.Path(__file__).resolve().parents[1] / 'scripts' / 'deployResidentialWorker.py'
SPEC = importlib.util.spec_from_file_location('deploy_residential_worker', PATH)
deploy = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(deploy)


class WorkerDeploymentTest(unittest.TestCase):
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
        self.assertIn('--args=scripts/residentialBrochureWorker.js,--check-storage', calls[-1])


if __name__ == '__main__':
    unittest.main()
