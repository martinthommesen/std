/**
 * Prints a check's problems to stderr, or a one-line success message to
 * stdout, and sets the exit code. Checks never call `process.exit`, so
 * pending output is always flushed.
 *
 * @param checkName - Prefix for the summary line.
 * @param problems - One message per problem; empty when the check passed.
 * @param success - The summary printed when there are no problems.
 */
export const report = (
  checkName: string,
  problems: readonly string[],
  success: string
): void => {
  if (problems.length === 0) {
    process.stdout.write(`${checkName}: ${success}\n`);

    return;
  }

  for (const problem of problems) {
    process.stderr.write(`${problem}\n`);
  }

  process.stderr.write(
    `${checkName}: ${problems.length} problem${problems.length === 1 ? "" : "s"}\n`
  );
  process.exitCode = 1;
};

/**
 * Runs a check body and turns an unexpected exception into a failure.
 *
 * @param checkName - Prefix for the error message.
 * @param body - The check; it reports through {@link report}.
 */
export const runCheck = async (
  checkName: string,
  body: () => void | Promise<void>
): Promise<void> => {
  try {
    await body();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`${checkName}: ${message}\n`);
    process.exitCode = 1;
  }
};
