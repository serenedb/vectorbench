from vectorbench.runner import point_slice


def test_slices_of_a_group_are_disjoint_and_skip_the_last_query():
    order = list(range(10000))
    for npoints, want in ((26, 1000), (13, 500), (2, 200), (1, 4)):
        seen: set[int] = set()
        for li in range(npoints):
            s = point_slice(order, li, npoints, want)
            assert 0 < len(s) <= want
            assert not seen & set(s)
            seen |= set(s)
        assert order[-1] not in seen


def test_slice_size_is_capped_by_the_number_of_points():
    order = list(range(10000))
    assert len(point_slice(order, 0, 26, 1000)) == 384
    assert len(point_slice(order, 0, 13, 500)) == 500
