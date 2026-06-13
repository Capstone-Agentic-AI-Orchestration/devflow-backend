import { BadRequestException, Injectable, PipeTransform } from '@nestjs/common';
import type { ZodSchema, ZodError } from 'zod';

/**
 * ZodValidationPipe
 *
 * A NestJS pipe that validates and transforms incoming data against a Zod schema.
 * Throws a BadRequestException with field-level error details when validation fails.
 *
 * Usage:
 *   @Body(new ZodValidationPipe(CreateProjectSchema)) body: CreateProjectDto
 */
@Injectable()
export class ZodValidationPipe<T> implements PipeTransform {
  constructor(private readonly schema: ZodSchema<T>) {}

  transform(value: unknown): T {
    const result = this.schema.safeParse(value);

    if (!result.success) {
      const zodError = result.error as ZodError;
      const message = zodError.errors
        .map((issue) => `${issue.path.join('.')}: ${issue.message}`)
        .join('; ');

      throw new BadRequestException(`Validation failed: ${message}`);
    }

    return result.data;
  }
}
