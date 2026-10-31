module.exports = {
  preset: 'ts-jest/presets/default-esm',
  testEnvironment: 'node',
  testMatch: ['**/tests/**/*.test.ts'],
  extensionsToTreatAsEsm: ['.ts', '.tsx'],
  transform: { '^.+\\.tsx?$': ['ts-jest', { useESM: true }] },
};
