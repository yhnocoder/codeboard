use pyo3::prelude::*;

#[pyfunction]
fn tokenize(s: &str) -> usize {
    s.len()
}

#[pymodule]
fn fasttok(m: &Bound<'_, PyModule>) -> PyResult<()> {
    m.add_function(wrap_pyfunction!(tokenize, m)?)?;
    Ok(())
}
