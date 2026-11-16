use pyo3::prelude::*;

#[pyfunction]
fn tokenize(s: &str) -> usize { s.len() }

#[pyfunction]
#[pyo3(name = "radix_insert")]
fn insert_impl(k: u32) {}

#[pyclass]
struct Tree {}

#[pymethods]
impl Tree {
    fn match_prefix(&self) {}
}

fn private_helper() {}
