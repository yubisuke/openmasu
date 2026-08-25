import { readFileSync } from "node:fs";

export interface SecretStore {
  read(name: string): string | undefined;
  require(name: string): string;
}

export type SecretEntry = {
  value?: string;
  file?: string;
};

export class EnvironmentSecretStore implements SecretStore {
  constructor(private readonly entries: Readonly<Record<string, SecretEntry>>) {}

  read(name: string): string | undefined {
    const entry = this.entries[name];
    if (!entry) return undefined;
    if (entry.value && entry.file) throw new Error(`${name} and ${name}_FILE cannot both be set`);
    if (entry.file) return readFileSync(entry.file, "utf8").trimEnd();
    return entry.value;
  }

  require(name: string): string {
    const value = this.read(name);
    if (!value) throw new Error(`${name} or ${name}_FILE is required`);
    return value;
  }
}
