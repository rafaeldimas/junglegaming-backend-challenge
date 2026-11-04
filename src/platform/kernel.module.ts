import { Global, Module } from '@nestjs/common';
import { CLOCK, SystemClock } from '../shared/domain/clock.js';
import {
  ID_GENERATOR,
  UuidV7Generator,
} from '../shared/domain/id-generator.js';

@Global()
@Module({
  providers: [
    { provide: CLOCK, useClass: SystemClock },
    { provide: ID_GENERATOR, useClass: UuidV7Generator },
  ],
  exports: [CLOCK, ID_GENERATOR],
})
export class KernelModule {}
