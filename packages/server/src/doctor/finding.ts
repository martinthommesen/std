/**
 * Findings of `std doctor` (Contracts 1.10) and the exit code they give:
 * 0 when clean, 1 on any error, 2 for warnings only. Informational findings
 * do not affect the exit code.
 */

/** How serious a finding is. */
export type Severity = "error" | "warning" | "info";

/** One finding of one check. */
export interface Finding {
  /**
   * The check's number in Contracts 1.10 (1 to 16), or 0 for `doctor`
   * itself (`diagnosticTimeout`: it could not finish its checks).
   */
  readonly check: number;
  /** A stable code, for example `columnMissing` or `effectiveMismatch`. */
  readonly code: string;
  readonly severity: Severity;
  readonly message: string;
  /** What the finding is about: a table, a definition ID, a change set. */
  readonly subject: string | null;
}

/** Exit code: clean. */
export const EXIT_CLEAN = 0;

/** Exit code: at least one error. */
export const EXIT_ERRORS = 1;

/** Exit code: warnings, no errors. */
export const EXIT_WARNINGS = 2;

/**
 * The exit code of a set of findings.
 *
 * @param findings - Every finding.
 * @returns 1 on any error, 2 for warnings only, otherwise 0.
 */
export const exitCodeOf = (findings: readonly Finding[]): number => {
  if (findings.some((finding) => finding.severity === "error")) {
    return EXIT_ERRORS;
  }

  return findings.some((finding) => finding.severity === "warning")
    ? EXIT_WARNINGS
    : EXIT_CLEAN;
};

/**
 * Builds a finding.
 *
 * @param check - The check's number.
 * @param severity - Error, warning or info.
 * @param code - The stable code.
 * @param message - What is wrong, naming objects by name or ID.
 * @param subject - What it is about.
 * @returns The finding.
 */
export const finding = (
  check: number,
  severity: Severity,
  code: string,
  message: string,
  subject: string | null = null
): Finding => ({ check, code, message, severity, subject });
