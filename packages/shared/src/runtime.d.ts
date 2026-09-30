// This package runs in browsers and in Node, so it compiles with neither DOM nor Node types
// (see tsconfig.json) to keep runtime-specific APIs out. Both runtimes provide the WHATWG URL
// class, so the subset used here is declared by hand. Consumers use their runtime's own type.
declare class URL {
  constructor(input: string, base?: string);
  readonly href: string;
  readonly protocol: string;
  readonly username: string;
  readonly password: string;
  readonly search: string;
  readonly hash: string;
  readonly host: string;
}
