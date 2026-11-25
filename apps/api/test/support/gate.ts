/** A promise and the function that settles it: lets a test hold a handler or transaction open. */
export function gate<T = void>(): { wait: Promise<T>; open(value: T): void } {
  let open!: (value: T) => void;
  const wait = new Promise<T>((resolve) => {
    open = resolve;
  });
  return { wait, open };
}
