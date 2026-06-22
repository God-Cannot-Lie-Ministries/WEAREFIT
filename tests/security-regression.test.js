const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const root = path.resolve(__dirname, "..");

test("database grants do not let browser users update profile roles", () => {
  const migration = fs.readFileSync(
    path.join(root, "supabase/migrations/202606210001_lock_profile_role_updates.sql"),
    "utf8",
  );
  assert.match(migration, /revoke\s+update\s+on\s+public\.profiles\s+from\s+authenticated/i);
  assert.match(migration, /grant\s+update\s*\(\s*full_name\s*,\s*updated_at\s*\)\s+on\s+public\.profiles\s+to\s+authenticated/i);
  assert.doesNotMatch(migration, /grant\s+update\s*\([^)]*role/i);
});

test("production backend removes private inline file data before database persistence", () => {
  const backend = fs.readFileSync(path.join(root, "backend.js"), "utf8");
  assert.match(backend, /delete\s+cleaned\.password/);
  assert.match(backend, /delete\s+cleaned\.verificationCode/);
  assert.match(backend, /delete\s+photo\.dataUrl/);
  assert.match(backend, /delete\s+paystub\.dataUrl/);
});

test("member coach cards preserve secure signed coach photo urls", () => {
  const backend = fs.readFileSync(path.join(root, "backend.js"), "utf8");
  const app = fs.readFileSync(path.join(root, "app.js"), "utf8");
  assert.match(backend, /function\s+needsSignedPhotoUrl/);
  assert.match(backend, /coachPhotoNeedsSignedUrl/);
  assert.match(backend, /if\s*\(!photo\.dataUrl\)\s*delete\s+photo\.dataUrl/);
  assert.doesNotMatch(app, /catch\s*\(error\)\s*{\s*coach\s*=\s*{\s*name:\s*"F\.I\.T\. coach"/);
});
