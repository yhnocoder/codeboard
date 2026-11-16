# mypy: allow-untyped-defs
"""torch.multiprocessing is a wrapper around the native :mod:`multiprocessing` module.

It registers custom reducers, that use shared memory to provide shared
views on the same data in different processes."""
import sys
