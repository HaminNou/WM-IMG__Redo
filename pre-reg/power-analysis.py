#!/usr/bin/env python3
"""Reproduces every power figure quoted in pre-reg.json -> sampling_plan.power_analysis.

Requires numpy and scipy (python3 pre-reg/power-analysis.py). Prints plain text.

1. Modality x Load interaction of the 2 x 2 within-subjects design (m = 4 repeated
   measurements), Cohen's f = 0.25, alpha = .05, target power .85.  The test has one
   numerator degree of freedom, df = (1, N - 1), and noncentrality
   lambda = f^2 * N * m / (1 - rho)   (the G*Power 'repeated measures, within factors'
   definition).  rho is the correlation among repeated measures.
2. One-tailed paired t-tests (H1, H2, and the two tests of H4) at the smallest effect of
   interest d = 0.4, alpha = .05.
"""
import numpy as np
from scipy import stats


def power_interaction(n, f=0.25, m=4, rho=0.0, alpha=0.05):
    lam = f**2 * n * m / (1 - rho)
    d1, d2 = 1, n - 1
    crit = stats.f.ppf(1 - alpha, d1, d2)
    return 1 - stats.ncf.cdf(crit, d1, d2, lam)


def min_n(power_fn, target):
    n = 3
    while power_fn(n) < target:
        n += 1
    return n


def power_paired_t(n, d=0.4, alpha=0.05):
    df = n - 1
    crit = stats.t.ppf(1 - alpha, df)
    return 1 - stats.nct.cdf(crit, df, d * np.sqrt(n))


if __name__ == "__main__":
    print("Modality x Load interaction, f = .25, alpha = .05, power >= .85, df = (1, N-1)")
    for rho in (0.0, 0.3, 0.5):
        print(f"  rho = {rho}: N = {min_n(lambda n: power_interaction(n, rho=rho), 0.85)}")
    print("  (pre-registered computed_n = 38 corresponds to rho = 0)")
    print()
    print("One-tailed paired t, d = 0.4, alpha = .05")
    for n in (38, 40, 47, 60, 100):
        print(f"  N = {n:3d}: power = {power_paired_t(n):.3f}")
    for target in (0.80, 0.85):
        print(f"  smallest N for power >= {target}: {min_n(power_paired_t, target)}")
    print()
    print("H4 (both one-tailed tests must pass; two independent tests approximation)")
    for n in (40, 47, 60):
        print(f"  N = {n:3d}: joint power ~ {power_paired_t(n) ** 2:.3f}")
