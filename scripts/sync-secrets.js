/* eslint-disable no-console */
/**
 * Script to sync environment variables from a local .env file to Google Cloud Secret Manager.
 *
 * This script reads a specified .env file and for each variable, it creates a new secret
 * in Secret Manager or adds a new version to an existing secret.
 *
 * Prerequisites:
 * 1. You must have the Google Cloud SDK installed and authenticated:
 *    `gcloud auth application-default login`
 * 2. The user or service account running this script must have the 'Secret Manager Admin'
 *    role (`roles/secretmanager.admin`) on the project.
 * 3. Install the necessary client library:
 *    `npm install @google-cloud/secret-manager`
 *
 * Usage:
 *    node scripts/sync-secrets.js [path/to/your/.env.file]
 *
 * Example:
 *    node scripts/sync-secrets.js .env
 */

const fs = require('fs');
const path = require('path');
const { SecretManagerServiceClient } = require('@google-cloud/secret-manager');

// --- Configuration ---
// Your Google Cloud project ID.
// It's best to set this as an environment variable or retrieve it automatically.
const projectId = process.env.GCLOUD_PROJECT || process.env.GOOGLE_CLOUD_PROJECT;
if (!projectId) {
  console.error('Error: Google Cloud project ID not found.');
  console.error('Please set the GCLOUD_PROJECT or GOOGLE_CLOUD_PROJECT environment variable.');
  process.exit(1);
}

const envFilePath = process.argv[2];
if (!envFilePath) {
  console.error('Error: Please provide the path to your .env file as an argument.');
  console.log('Usage: node scripts/sync-secrets.js <path/to/.env.file>');
  process.exit(1);
}

// --- Main Logic ---

// Instantiates a client
const client = new SecretManagerServiceClient();

async function syncSecrets() {
  console.log(`Starting secret sync for project '${projectId}'...`);

  const fileContent = fs.readFileSync(path.resolve(envFilePath), 'utf8');
  const envVars = parseEnv(fileContent);

  if (Object.keys(envVars).length === 0) {
    console.log('No variables found in the .env file. Exiting.');
    return;
  }

  for (const [key, value] of Object.entries(envVars)) {
    await createOrUpdateSecret(key, value);
  }

  console.log('\nSecret sync completed successfully!');
}

/**
 * Parses a .env file content into a key-value object.
 * Handles comments and empty lines.
 * @param {string} content The content of the .env file.
 * @returns {Object<string, string>}
 */
function parseEnv(content) {
  const env = {};
  content.split('\n').forEach(line => {
    const trimmedLine = line.trim();
    if (trimmedLine && !trimmedLine.startsWith('#')) {
      const match = trimmedLine.match(/^([^=]+)=(.*)$/);
      if (match) {
        const key = match[1].trim();
        let value = match[2].trim();
        // Remove quotes if they exist
        if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
          value = value.substring(1, value.length - 1);
        }
        env[key] = value;
      }
    }
  });
  return env;
}

async function createOrUpdateSecret(secretId, value) {
  const parent = `projects/${projectId}`;
  const secretPath = `${parent}/secrets/${secretId}`;

  try {
    // Try to get the secret to see if it exists
    await client.getSecret({ name: secretPath });
    console.log(`- Secret '${secretId}' already exists. Adding a new version...`);
  } catch (error) {
    if (error.code === 5) { // 5 = NOT_FOUND
      console.log(`- Secret '${secretId}' not found. Creating it...`);
      await client.createSecret({
        parent,
        secretId,
        secret: { replication: { automatic: {} } },
      });
    } else {
      throw error; // Re-throw other errors
    }
  }

  // Add the secret version.
  await client.addSecretVersion({
    parent: secretPath,
    payload: { data: Buffer.from(value, 'utf8') },
  });
  console.log(`  > Successfully added new version for '${secretId}'.`);
}

syncSecrets().catch(console.error);