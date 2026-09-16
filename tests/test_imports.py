"""Every driver module imports.

A syntax error in a module the other tests do not import is invisible until a run starts, and by
then the machine has usually been handed a multi-hour job. This is the cheapest possible guard
against that.
"""

from __future__ import annotations

import importlib
import pkgutil

import pytest

import vectorbench

MODULES = sorted(m.name for m in pkgutil.walk_packages(vectorbench.__path__, "vectorbench."))


def test_there_are_modules_to_check():
    assert len(MODULES) > 5, MODULES


@pytest.mark.parametrize("name", MODULES)
def test_module_imports(name):
    importlib.import_module(name)
