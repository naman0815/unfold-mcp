const { test, expect } = require('@playwright/test');

test('Mock server returns transactions', async ({ request }) => {
  const response = await request.get('http://localhost:5001/transactions');
  expect(response.ok()).toBeTruthy();
  const data = await response.json();
  expect(data.transactions).toBeDefined();
});
