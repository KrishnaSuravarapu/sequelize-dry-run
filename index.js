const path = require("path");
const { Umzug, SequelizeStorage } = require("umzug");

const METADATA_QUERIES = /^(pragma|show|describe|select)|information_schema/i;

/**
 * Creates a dry-run migration executor
 * @param {Object} options Configuration options
 * @param {Object} options.sequelize Sequelize instance
 * @param {string} options.migrationsPath Path to migrations folder (absolute or relative to cwd)
 * @param {string} [options.tableName='SequelizeMeta'] Name of the migrations table
 * @param {boolean} [options.verbose=false] Enable verbose logging
 * @param {Object} [options.logger] Custom logger instance (must have log/info/error methods). Defaults to console
 * @returns {Object} Migration executor with up/down methods
 */
function createDryRun(options) {
  const {
    sequelize,
    migrationsPath,
    tableName = "SequelizeMeta",
    verbose = false,
    logger = console,
  } = options;

  if (!sequelize) {
    throw new Error("sequelize instance is required");
  }

  if (!migrationsPath) {
    throw new Error("migrationsPath is required");
  }

  // Store original methods
  const originals = {
    query: sequelize.query.bind(sequelize),
    logMigration: SequelizeStorage.prototype.logMigration,
    unlogMigration: SequelizeStorage.prototype.unlogMigration,
  };

  const capturedQueries = [];

  // Helper: Check if query should pass through
  const shouldPassThrough = (sql) => {
    const lower = sql.toLowerCase();
    return (
      (lower.startsWith("select") && lower.includes(tableName.toLowerCase())) ||
      METADATA_QUERIES.test(lower)
    );
  };

  // Helper: Format captured SQL
  const formatQueries = (name, direction, queries) => {
    const output = [];
    output.push("\n" + "=".repeat(70));
    output.push(`📄 Migration ${direction.toUpperCase()}: ${name}`);
    output.push("=".repeat(70));

    if (!queries.length) {
      output.push("(No SQL generated)\n");
      return output.join("\n");
    }

    queries.forEach((sql, i) => output.push(`${i + 1}. ${sql}\n`));
    return output.join("\n");
  };

  // Patch SequelizeStorage to prevent SequelizeMeta writes
  const setupStoragePatch = () => {
    SequelizeStorage.prototype.logMigration = async () => {};
    SequelizeStorage.prototype.unlogMigration = async () => {};
  };

  // Patch sequelize.query to capture SQL
  const setupQueryPatch = () => {
    sequelize.query = async (sql, options = {}) => {
      if (typeof sql !== "string") return originals.query(sql, options);

      if (shouldPassThrough(sql)) return originals.query(sql, options);

      capturedQueries.push(sql);

      const { type } = options;
      if (type === sequelize.constructor.QueryTypes.SELECT)
        return originals.query(sql, options);
      if (
        [
          sequelize.constructor.QueryTypes.INSERT,
          sequelize.constructor.QueryTypes.UPDATE,
          sequelize.constructor.QueryTypes.DELETE,
        ].includes(type)
      ) {
        return [0, 0];
      }
      return [[], {}];
    };
  };

  // Restore original methods
  const restore = () => {
    sequelize.query = originals.query;
    SequelizeStorage.prototype.logMigration = originals.logMigration;
    SequelizeStorage.prototype.unlogMigration = originals.unlogMigration;
  };

  /**
   * Run pending migrations in dry-run mode
   * @param {Object} [opts] Options
   * @param {Function} [opts.onMigration] Callback called for each migration with (name, sql)
   * @returns {Promise<Array>} Array of migration results
   */
  const up = async (opts = {}) => {
    const { onMigration } = opts;
    const results = [];

    try {
      setupStoragePatch();
      setupQueryPatch();

      const migrationsGlob = path.isAbsolute(migrationsPath)
        ? path.join(migrationsPath, "*.js")
        : path.join(process.cwd(), migrationsPath, "*.js");

      const umzug = new Umzug({
        migrations: { glob: migrationsGlob },
        context: sequelize.getQueryInterface(),
        storage: new SequelizeStorage({ sequelize, tableName }),
        logger: verbose ? console : null,
      });

      const pending = await umzug.pending();

      if (!pending.length) {
        if (verbose) logger.log("✓ No pending migrations");
        return results;
      }

      if (verbose) {
        logger.log(`Found ${pending.length} pending migration(s):`);
        pending.forEach((m, i) => logger.log(`  ${i + 1}. ${m.name}`));
      }

      for (const migration of pending) {
        const startIdx = capturedQueries.length;
        const migrationPath = path.join(
          path.isAbsolute(migrationsPath)
            ? migrationsPath
            : path.join(process.cwd(), migrationsPath),
          migration.name
        );
        const mod = require(migrationPath);
        await mod.up(sequelize.getQueryInterface(), sequelize.constructor);

        // Add SequelizeMeta operation
        capturedQueries.push(
          `INSERT INTO \`${tableName}\` (\`name\`) VALUES ('${migration.name}');`
        );

        const queries = capturedQueries.slice(startIdx);
        const output = formatQueries(migration.name, "up", queries);

        results.push({
          name: migration.name,
          direction: "up",
          sql: queries,
          output,
        });

        if (verbose) logger.log(output);
        if (onMigration) onMigration(migration.name, queries);
      }

      if (verbose) logger.log("\n✓ Dry run completed — NO database changes made");
    } finally {
      restore();
    }

    return results;
  };

  /**
   * Rollback last migration in dry-run mode
   * @param {Object} [opts] Options
   * @param {Function} [opts.onMigration] Callback called with (name, sql)
   * @returns {Promise<Object|null>} Migration result or null if no migrations to rollback
   */
  const down = async (opts = {}) => {
    const { onMigration } = opts;
    let result = null;

    try {
      setupStoragePatch();
      setupQueryPatch();

      const migrationsGlob = path.isAbsolute(migrationsPath)
        ? path.join(migrationsPath, "*.js")
        : path.join(process.cwd(), migrationsPath, "*.js");

      const umzug = new Umzug({
        migrations: { glob: migrationsGlob },
        context: sequelize.getQueryInterface(),
        storage: new SequelizeStorage({ sequelize, tableName }),
        logger: verbose ? console : null,
      });

      const executed = await umzug.executed();

      if (!executed.length) {
        if (verbose) logger.log("✓ No migrations to rollback");
        return null;
      }

      const lastMigration = executed[executed.length - 1];
      if (verbose) logger.log(`Last executed migration: ${lastMigration.name}\n`);

      const startIdx = capturedQueries.length;
      const migrationPath = path.join(
        path.isAbsolute(migrationsPath)
          ? migrationsPath
          : path.join(process.cwd(), migrationsPath),
        lastMigration.name
      );
      const mod = require(migrationPath);
      await mod.down(sequelize.getQueryInterface(), sequelize.constructor);

      // Add SequelizeMeta operation
      capturedQueries.push(
        `DELETE FROM \`${tableName}\` WHERE \`name\` = '${lastMigration.name}';`
      );

      const queries = capturedQueries.slice(startIdx);
      const output = formatQueries(lastMigration.name, "down", queries);

      result = {
        name: lastMigration.name,
        direction: "down",
        sql: queries,
        output,
      };

      if (verbose) logger.log(output);
      if (onMigration) onMigration(lastMigration.name, queries);

      if (verbose) logger.log("\n✓ Dry run completed — NO database changes made");
    } finally {
      restore();
    }

    return result;
  };

  return {
    up,
    down,
  };
}

module.exports = { createDryRun };
