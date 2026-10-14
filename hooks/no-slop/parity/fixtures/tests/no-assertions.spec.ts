describe('runner', () => {
  it('starts the worker and drains the queue', () => {
    const worker = start();
    worker.drain();
  });
});
