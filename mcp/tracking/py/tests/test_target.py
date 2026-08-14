# mcp/tracking/py/tests/test_target.py
import numpy as np

from libitrack.target import TargetTemplate


def _unit(i: int, d: int = 8) -> np.ndarray:
    v = np.zeros(d, dtype=np.float32)
    v[i % d] = 1.0
    return v


def test_empty_template_similarity_is_none():
    t = TargetTemplate()
    assert t.empty is True
    assert len(t) == 0
    assert t.similarity(_unit(0)) is None


def test_add_and_max_similarity():
    t = TargetTemplate(maxlen=4)
    t.add(_unit(0))
    t.add(_unit(1))
    assert len(t) == 2
    assert abs(t.similarity(_unit(1)) - 1.0) < 1e-6   # matches ring[1]
    assert abs(t.similarity(_unit(5))) < 1e-6         # orthogonal to all


def test_ring_evicts_oldest_when_full():
    t = TargetTemplate(maxlen=2)
    t.add(_unit(0))
    t.add(_unit(1))
    t.add(_unit(2))            # evicts _unit(0)
    assert len(t) == 2
    assert abs(t.similarity(_unit(0))) < 1e-6
    assert abs(t.similarity(_unit(2)) - 1.0) < 1e-6


def test_add_ignores_degenerate():
    t = TargetTemplate()
    t.add(None)
    t.add(np.zeros(8, dtype=np.float32))
    assert t.empty is True


def test_similarity_none_query_on_nonempty_ring_is_none():
    t = TargetTemplate()
    t.add(_unit(0))
    assert t.similarity(None) is None
