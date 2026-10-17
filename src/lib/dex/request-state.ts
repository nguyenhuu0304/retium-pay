/** Bound read-only work without changing wallet submission or recovery rules. */
export async function withDeadline<T>(
  task: () => Promise<T>,
  milliseconds: number,
  errorMessage: string,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      Promise.resolve().then(task),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(errorMessage)), milliseconds);
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}
