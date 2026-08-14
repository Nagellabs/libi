# mcp/tracking/py/tests/test_associate_reid_backend.py
from libitrack.associate import Associator


def test_motion_only_exposes_none_backend():
    a = Associator(with_reid=False)
    assert hasattr(a, "reid_backend")
    assert a.reid_backend is None


def test_reset_keeps_reid_backend_attr():
    a = Associator(with_reid=False)
    a.reset()
    assert hasattr(a, "reid_backend")
    assert a.reid_backend is None
