import { describe, expect, it } from 'vitest';
import { setLang } from '../../src/i18n';
import { orderCompHint } from '../../src/ui/orderHint';

describe('the one-time hint about the turn-order compensation', () => {
  it('says the first mover sits out its first attack, and what it gets for that', () => {
    setLang('ru');
    expect(orderCompHint({ skip: 1, bonus: [4, 0] })).toBe('Кто ходит первым, пропускает атаку в первом раунде, зато получает +4 к подкреплению.');
  });

  it('without extra income for it, says only that the first mover sits out', () => {
    setLang('ru');
    expect(orderCompHint({ skip: 1, bonus: [0, 1] })).toBe('Кто ходит первым, пропускает атаку в первом раунде.');
  });

  it('names how many early seats sit out', () => {
    setLang('ru');
    expect(orderCompHint({ skip: 2 })).toBe('В первом раунде первые 2 по очереди пропускают атаку.');
  });

  it('explains a snake order', () => {
    setLang('ru');
    expect(orderCompHint({ order: 'snake' })).toBe('Ходы идут змейкой: каждый второй раунд — в обратном порядке.');
  });

  it('keeps the extra income of later seats, and stays silent with nothing to say', () => {
    setLang('ru');
    expect(orderCompHint({ bonus: [0, 1, 2] })).toBe('Кто ходит позже, получит больше силы в первом подкреплении — до +2.');
    expect(orderCompHint({ bonus: [0, 0] })).toBeNull();
    expect(orderCompHint(undefined)).toBeNull();
    expect(orderCompHint('off')).toBeNull();
  });
});
