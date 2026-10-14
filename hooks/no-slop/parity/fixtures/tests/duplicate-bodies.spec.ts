describe('runner', () => {
  it('handles one', () => {
    const input = build(1);
    const output = run(input);
    expect(output).toBe(1);
  });

  it('handles two', () => {
    const input = build(2);
    const output = run(input);
    expect(output).toBe(2);
  });
});
