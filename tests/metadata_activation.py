"""First executable activation checkpoint: default-off, no silent fallback."""
import argparse,pathlib,sys,unittest
from types import SimpleNamespace as NS
ap=argparse.ArgumentParser();ap.add_argument('--gateway-source',required=True);args=ap.parse_args()
sys.path.insert(0,str(pathlib.Path(args.gateway_source).resolve()/'src'))
from mcp_gateway.config import BackendConfig
from mcp_gateway.gateway import build_gateway
from pydantic import ValidationError

class Activation(unittest.TestCase):
    def test_existing_default_is_off(self):
        value=BackendConfig(url='http://fixture.invalid/mcp')
        self.assertFalse(value.isolate_metadata);self.assertIsNone(value.metadata_profile)
    def test_explicit_false_preserves_custom_auth(self):
        for auth in [{'type':'none'},{'type':'headers','headers':{'x-fixture':'owned'}},{'type':'oauth'}]:
            with self.subTest(kind=auth['type']):
                self.assertFalse(BackendConfig(url='http://fixture.invalid/mcp',auth=auth,isolate_metadata=False).isolate_metadata)
    def test_boolean_is_strict(self):
        for value in ['true','false',0,1,None,[],{}]:
            with self.subTest(value=value),self.assertRaises(ValidationError):
                BackendConfig(url='http://fixture.invalid/mcp',isolate_metadata=value)
    def test_profile_required_and_known(self):
        for profile in [None,'unreviewed-v2',False,1]:
            with self.subTest(profile=profile),self.assertRaises(ValidationError):
                BackendConfig(url='http://fixture.invalid/mcp',auth={'type':'bearer','token':'fixture-only'},isolate_metadata=True,metadata_profile=profile)
    def test_orphan_profile_rejected(self):
        with self.assertRaises(ValidationError):BackendConfig(url='http://fixture.invalid/mcp',metadata_profile='bounded-v1')
    def test_opted_auth_not_silently_changed(self):
        for kind in ['none','oauth']:
            with self.subTest(kind=kind),self.assertRaises(ValidationError):
                BackendConfig(url='http://fixture.invalid/mcp',auth={'type':kind},isolate_metadata=True,metadata_profile='bounded-v1')
    def test_enabled_selection_refuses_unimplemented_assembly(self):
        backend=BackendConfig(url='http://fixture.invalid/mcp',auth={'type':'bearer','token':'fixture-only'},isolate_metadata=True,metadata_profile='bounded-v1')
        with self.assertRaisesRegex(RuntimeError,'not available'):
            build_gateway(NS(backends={'probe_fixture':backend}),None,None,{})
    def test_default_off_gateway_still_assembles(self):
        self.assertIsNotNone(build_gateway(NS(backends={}),None,NS(backend_status=lambda:[]),{}))

if __name__=='__main__':unittest.main(argv=[sys.argv[0]],verbosity=2)
