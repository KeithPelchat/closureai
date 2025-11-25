require("dotenv").config();
const { Pool } = require("pg");

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: {
    rejectUnauthorized: false,   // RDS / self-hosted with SSL-only
  },
});

module.exports = {
  query: (text, params) => pool.query(text, params),
};
