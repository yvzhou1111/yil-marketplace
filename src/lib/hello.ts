/**
 * Tiny pure helper — easy to unit-test, exercises the boundary between
 * code and the rest of the system without touching I/O.
 */
export function hello(name: string): string {
  if (!name.trim()) {
    throw new Error("name must not be empty");
  }
  return `Hello, ${name.trim()}!`;
}