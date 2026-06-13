import { BadRequestException } from '@nestjs/common';
import { z } from 'zod';
import { ZodValidationPipe } from './zod-validation.pipe';

const schema = z.object({
  name: z.string().min(1),
  age: z.number().int().positive(),
});

describe('ZodValidationPipe', () => {
  let pipe: ZodValidationPipe<{ name: string; age: number }>;

  beforeEach(() => {
    pipe = new ZodValidationPipe(schema);
  });

  it('returns parsed value for valid input', () => {
    const result = pipe.transform({ name: 'Alice', age: 30 });
    expect(result).toEqual({ name: 'Alice', age: 30 });
  });

  it('throws BadRequestException for invalid input (empty name and negative age)', () => {
    expect(() => pipe.transform({ name: '', age: -1 })).toThrow(BadRequestException);
  });

  it('throws BadRequestException for missing required field', () => {
    expect(() => pipe.transform({ age: 25 })).toThrow(BadRequestException);
  });

  it('includes field path in error message', () => {
    try {
      pipe.transform({ name: '', age: 30 });
      fail('should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(BadRequestException);
      const message = (err as BadRequestException).message;
      expect(message).toContain('name');
    }
  });

  it('throws BadRequestException when value is not an object', () => {
    expect(() => pipe.transform(null)).toThrow(BadRequestException);
    expect(() => pipe.transform('string input')).toThrow(BadRequestException);
    expect(() => pipe.transform(42)).toThrow(BadRequestException);
  });

  it('throws BadRequestException when age is zero (not positive)', () => {
    expect(() => pipe.transform({ name: 'Bob', age: 0 })).toThrow(BadRequestException);
  });

  it('throws BadRequestException when age is not an integer', () => {
    expect(() => pipe.transform({ name: 'Bob', age: 1.5 })).toThrow(BadRequestException);
  });

  it('error message is a string (not an object)', () => {
    try {
      pipe.transform({ age: 25 });
    } catch (err) {
      expect(err).toBeInstanceOf(BadRequestException);
      expect(typeof (err as BadRequestException).message).toBe('string');
    }
  });
});
