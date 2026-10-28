const { normalizeKenyanPhone } = require('../utils/phone');

describe('normalizeKenyanPhone', () => {
  test.each([
    ['+254712345678', '+254712345678'],
    ['254712345678', '+254712345678'],
    ['0712345678', '+254712345678'],
    ['712345678', '+254712345678'],
    ['0112345678', '+254112345678'],
    ['+254 712 345 678', '+254712345678'],
    ['0712-345-678', '+254712345678'],
    ['(0712) 345.678', '+254712345678'],
    ['00254712345678', '+254712345678'],
    ['  254712345678  ', '+254712345678'],
  ])('normalizes %s', (input, expected) => {
    expect(normalizeKenyanPhone(input)).toBe(expected);
  });

  test.each([
    [''],
    ['+254'],
    ['0712'],
    ['071234567890'],
    ['0212345678'],
    ['+15551234567'],
    ['abc'],
    ['0712 34x 678'],
    [null],
    [undefined],
    [712345678],
  ])('rejects %p', (input) => {
    expect(normalizeKenyanPhone(input)).toBeNull();
  });
});
