export const info = (name: string, ...args: unknown[]) => {
  console.log(`${new Date().toISOString()} [${name}]`, ...args);
};
export const warn = (name: string, ...args: unknown[]) => {
  console.warn(`${new Date().toISOString()} [${name}]`, ...args);
};
export const error = (name: string, ...args: unknown[]) => {
  console.error(`${new Date().toISOString()} [${name}]`, ...args);
};
