use numpy::{IntoPyArray, PyArray1, PyArray2, PyReadonlyArray1, PyReadonlyArray2};
use pyo3::exceptions::PyValueError;
use pyo3::prelude::*;

fn validate_shapes(rows: usize, residuals: usize) -> PyResult<()> {
    if rows != residuals {
        return Err(PyValueError::new_err(
            "Jacobian and residual row counts must match",
        ));
    }
    Ok(())
}

#[pyfunction]
fn normal_equations<'py>(
    py: Python<'py>,
    jacobian: PyReadonlyArray2<'py, f64>,
    residuals: PyReadonlyArray1<'py, f64>,
) -> PyResult<(Bound<'py, PyArray2<f64>>, Bound<'py, PyArray1<f64>>)> {
    let j = jacobian.as_array();
    let r = residuals.as_array();
    let (rows, cols) = j.dim();
    validate_shapes(rows, r.len())?;
    let mut normal = vec![0.0_f64; cols * cols];
    let mut gradient = vec![0.0_f64; cols];
    let mut active = Vec::with_capacity(cols);
    for row in 0..rows {
        active.clear();
        for col in 0..cols {
            let value = j[(row, col)];
            if value != 0.0 {
                active.push((col, value));
                gradient[col] += value * r[row];
            }
        }
        for &(col, value) in &active {
            for &(other, other_value) in &active {
                normal[col * cols + other] += value * other_value;
            }
        }
    }
    for row in 0..cols {
        for col in 0..row {
            normal[row * cols + col] = normal[col * cols + row];
        }
    }
    let normal_array = ndarray::Array2::from_shape_vec((cols, cols), normal)
        .map_err(|error| PyValueError::new_err(error.to_string()))?;
    Ok((
        normal_array.into_pyarray(py),
        ndarray::Array1::from_vec(gradient).into_pyarray(py),
    ))
}

fn solve_linear_system(mut matrix: Vec<f64>, mut rhs: Vec<f64>, n: usize) -> Option<Vec<f64>> {
    for col in 0..n {
        let pivot = (col..n).max_by(|&a, &b| {
            matrix[a * n + col]
                .abs()
                .total_cmp(&matrix[b * n + col].abs())
        })?;
        let pivot_value = matrix[pivot * n + col];
        if !pivot_value.is_finite() || pivot_value.abs() <= f64::EPSILON {
            return None;
        }
        if pivot != col {
            for k in col..n {
                matrix.swap(col * n + k, pivot * n + k);
            }
            rhs.swap(col, pivot);
        }
        for row in (col + 1)..n {
            let factor = matrix[row * n + col] / matrix[col * n + col];
            matrix[row * n + col] = 0.0;
            for k in (col + 1)..n {
                matrix[row * n + k] -= factor * matrix[col * n + k];
            }
            rhs[row] -= factor * rhs[col];
        }
    }
    let mut solution = vec![0.0_f64; n];
    for row in (0..n).rev() {
        let mut value = rhs[row];
        for col in (row + 1)..n {
            value -= matrix[row * n + col] * solution[col];
        }
        solution[row] = value / matrix[row * n + row];
        if !solution[row].is_finite() {
            return None;
        }
    }
    Some(solution)
}

#[pyfunction]
fn solve_damped<'py>(
    py: Python<'py>,
    matrix: PyReadonlyArray2<'py, f64>,
    rhs: PyReadonlyArray1<'py, f64>,
) -> PyResult<Bound<'py, PyArray1<f64>>> {
    let a = matrix.as_array();
    let b = rhs.as_array();
    let (rows, cols) = a.dim();
    if rows != cols || b.len() != rows {
        return Err(PyValueError::new_err("matrix must be square and match rhs length"));
    }
    let solution = solve_linear_system(
        a.iter().copied().collect(),
        b.iter().copied().collect(),
        rows,
    )
    .ok_or_else(|| PyValueError::new_err("damped system is singular or non-finite"))?;
    Ok(ndarray::Array1::from_vec(solution).into_pyarray(py))
}

#[pymodule]
fn _native(module: &Bound<'_, PyModule>) -> PyResult<()> {
    module.add_function(wrap_pyfunction!(normal_equations, module)?)?;
    module.add_function(wrap_pyfunction!(solve_damped, module)?)?;
    Ok(())
}
