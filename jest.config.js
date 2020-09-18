/** @type {import('@jest/types/build/Config').InitialOptions} */
module.exports = {
    // preset: 'ts-jest',
    testEnvironment: 'node',
    testMatch: ['**/__tests__/**/*.js', '**/?(*.)+(spec|test).js'],
    roots: ['out'],
};
