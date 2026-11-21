declare module 'node:fs' {
  export function readFileSync(path: string | URL): Uint8Array;
}

declare module 'node:path' {
  export function dirname(p: string): string;
  export function resolve(...paths: string[]): string;
}

declare module 'node:url' {
  export function fileURLToPath(url: string | URL): string;
}
