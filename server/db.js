const fs = require('fs');
const path = require('path');
const knexLib = require('knex');

const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, '..', 'data');
fs.mkdirSync(DATA_DIR, { recursive: true });

const isMysql = process.env.DB_CLIENT === 'mysql';

const db = knexLib(isMysql
  ? {
      client: 'mysql2',
      connection: {
        host: process.env.DB_HOST || 'localhost',
        port: Number(process.env.DB_PORT || 3306),
        user: process.env.DB_USER,
        password: process.env.DB_PASSWORD,
        database: process.env.DB_NAME,
        charset: 'utf8mb4'
      },
      pool: { min: 0, max: 5 }
    }
  : {
      client: 'better-sqlite3',
      connection: { filename: process.env.SQLITE_FILE || path.join(DATA_DIR, 'mindmap.sqlite') },
      useNullAsDefault: true
    });

async function migrate() {
  const has = (t) => db.schema.hasTable(t);

  if (!(await has('users'))) {
    await db.schema.createTable('users', (t) => {
      t.increments('id');
      t.string('email', 191).notNullable().unique();
      t.string('password_hash', 100).notNullable();
      t.string('name', 120).notNullable().defaultTo('');
      t.string('role', 20).notNullable().defaultTo('user');
      t.boolean('disabled').notNullable().defaultTo(false);
      t.integer('token_version').notNullable().defaultTo(0);
      t.timestamp('created_at').defaultTo(db.fn.now());
      t.timestamp('last_login_at').nullable();
    });
  }

  if (!(await has('maps'))) {
    await db.schema.createTable('maps', (t) => {
      t.string('id', 36).primary();
      t.integer('owner_id').notNullable().index();
      t.string('title', 200).notNullable().defaultTo('');
      t.text('doc', 'longtext').notNullable();
      t.integer('version').notNullable().defaultTo(0);
      t.timestamp('created_at').defaultTo(db.fn.now());
      t.timestamp('updated_at').defaultTo(db.fn.now());
    });
  }

  if (!(await has('folders'))) {
    await db.schema.createTable('folders', (t) => {
      t.increments('id');
      t.integer('owner_id').notNullable().index();
      t.string('name', 120).notNullable();
      t.integer('parent_id').nullable().index();
      t.timestamp('created_at').defaultTo(db.fn.now());
    });
  }
  if (!(await db.schema.hasColumn('maps', 'folder_id'))) {
    await db.schema.alterTable('maps', (t) => { t.integer('folder_id').nullable().index(); });
  }

  if (!(await has('map_ops'))) {
    await db.schema.createTable('map_ops', (t) => {
      t.increments('id');
      t.string('map_id', 36).notNullable();
      t.integer('version').notNullable();
      t.text('op', 'mediumtext').notNullable();
      t.string('client_id', 64).notNullable().defaultTo('');
      t.timestamp('created_at').defaultTo(db.fn.now());
      t.index(['map_id', 'version']);
    });
  }

  if (!(await has('share_links'))) {
    await db.schema.createTable('share_links', (t) => {
      t.increments('id');
      t.string('map_id', 36).notNullable().index();
      t.string('token', 64).notNullable().unique();
      t.string('permission', 10).notNullable();
      t.string('label', 120).notNullable().defaultTo('');
      t.boolean('revoked').notNullable().defaultTo(false);
      t.timestamp('created_at').defaultTo(db.fn.now());
    });
  }

  if (!(await has('files'))) {
    await db.schema.createTable('files', (t) => {
      t.string('id', 36).primary();
      t.string('map_id', 36).notNullable().index();
      t.string('original_name', 255).notNullable();
      t.string('mime', 120).notNullable();
      t.bigInteger('size').notNullable();
      t.string('stored_name', 120).notNullable();
      t.integer('uploaded_by').nullable();
      t.timestamp('created_at').defaultTo(db.fn.now());
    });
  }
}

module.exports = { db, migrate, isMysql, DATA_DIR };
