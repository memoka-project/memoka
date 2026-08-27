export interface KeyBinding<Context extends string, Command extends string> {
  context: Context;
  sequence: string;
  command: Command;
}

function bindingKey(context: string, sequence: string): string {
  return `${context}\u0000${sequence}`;
}

/**
 * Resolves input sequences to typed Commands without binding UI events to
 * editor callbacks or CRDT transactions. Contexts are intentionally generic
 * so the same table can serve the Note editor, Tree, Search, and Command-line.
 */
export class DeclarativeKeymap<Context extends string, Command extends string> {
  private readonly commands = new Map<string, Command>();
  private readonly declaredBindings: readonly KeyBinding<Context, Command>[];

  constructor(
    bindings: readonly KeyBinding<Context, Command>[],
    knownCommands: readonly Command[],
  ) {
    const commandCatalog = new Set<Command>();
    for (const command of knownCommands) {
      if (command.length === 0) {
        throw new Error("Keymap command ID must not be empty");
      }
      if (commandCatalog.has(command)) {
        throw new Error(`Duplicate keymap command ID: ${command}`);
      }
      commandCatalog.add(command);
    }
    this.declaredBindings = bindings.map((binding) => ({ ...binding }));
    for (const binding of this.declaredBindings) {
      if (binding.context.length === 0) {
        throw new Error("Key binding context must not be empty");
      }
      if (binding.sequence.length === 0) {
        throw new Error("Key binding sequence must not be empty");
      }
      if (!commandCatalog.has(binding.command)) {
        throw new Error(`Unknown keymap command: ${binding.command}`);
      }
      const key = bindingKey(binding.context, binding.sequence);
      if (this.commands.has(key)) {
        throw new Error(
          `Duplicate key binding: ${binding.context}:${binding.sequence}`,
        );
      }
      this.commands.set(key, binding.command);
    }
  }

  resolve(context: Context, sequence: string): Command | null {
    return this.commands.get(bindingKey(context, sequence)) ?? null;
  }

  bindings(): readonly KeyBinding<Context, Command>[] {
    return this.declaredBindings.map((binding) => ({ ...binding }));
  }
}
