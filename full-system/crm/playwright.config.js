const { defineConfig } = require('@playwright/test');

module.exports = defineConfig({
  testDir: './e2e',
  timeout: 30000,
  use: {
    baseURL: process.env.BASE_URL || 'http://127.0.0.1:8080',
    headless: true,
    trace: 'retain-on-failure'
  },
  webServer: {
    command: 'node server.js',
    url: 'http://127.0.0.1:8080/login.html',
    reuseExistingServer: false,
    timeout: 30000,
    env: {
      NODE_ENV: 'test',
      STORAGE_MODE: 'json',
      PORT: '8080'
    }
  }
});
