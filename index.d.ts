export interface DryRunOptions {
  sequelize: any;
  migrationsPath: string;
  tableName?: string;
  verbose?: boolean;
  logger?: {
    log: (...args: any[]) => void;
    info?: (...args: any[]) => void;
    error?: (...args: any[]) => void;
  };
}

export interface MigrationResult {
  name: string;
  direction: 'up' | 'down';
  sql: string[];
  output: string;
}

export interface DryRunExecutor {
  up(options?: { onMigration?: (name: string, queries: string[]) => void }): Promise<MigrationResult[]>;
  down(options?: { onMigration?: (name: string, queries: string[]) => void }): Promise<MigrationResult | null>;
}

export function createDryRun(options: DryRunOptions): DryRunExecutor;
