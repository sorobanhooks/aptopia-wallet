/** @type {import('jest').Config} */
module.exports = {
  preset: 'ts-jest',
  testEnvironment: 'node',
  testMatch: ['**/__tests__/**/*.test.ts'],
  transform: {
    '^.+\\.ts$': [
      'ts-jest',
      {
        tsconfig: {
          module: 'CommonJS',
          moduleResolution: 'node',
          esModuleInterop: true,
          strict: true,
          skipLibCheck: true,
        },
      },
    ],
  },
  moduleNameMapper: {
    // Strip .js extensions that NodeNext-style imports use
    '^(\\.{1,2}/.*)\\.js$': '$1',
  },
};
