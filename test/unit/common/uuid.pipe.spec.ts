import { ApiException } from '../../../src/common/api-exception.js';
import { UuidPipe } from '../../../src/common/uuid.pipe.js';

const pipe = new UuidPipe();

it('acepta la forma 8-4-4-4-12 hexadecimal', () => {
  const id = '0b427a9f-d598-4668-ba21-787c34379f5f';
  expect(pipe.transform(id)).toBe(id);
});

it.each(['', 'abc', '0b427a9fd5984668ba21787c34379f5f', '0b427a9f-d598-4668-ba21-787c34379f5g'])(
  'rechaza %j con 400 MALFORMED_REQUEST',
  (value) => {
    expect(() => pipe.transform(value)).toThrow(ApiException);
    try {
      pipe.transform(value);
    } catch (e) {
      expect(e).toMatchObject({ status: 400, errorCode: 'MALFORMED_REQUEST', detail: 'La petición está mal formada' });
    }
  },
);
