'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { updateStage } = require('../src/services/karmaGroupScraperService');

test('scrape status advances from project mutation into media storage', () => {
  const status = { currentStage: 'project-mutation', startedAt: new Date().toISOString() };

  updateStage(status, 'media-storage', { selectedProjectName: 'AVADH PALOMA PRIDE' });

  assert.equal(status.currentStage, 'media-storage');
  assert.equal(status.selectedProjectName, 'AVADH PALOMA PRIDE');
  assert.ok(status.lastProgressAt);
});
