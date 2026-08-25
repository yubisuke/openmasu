using System;
using System.Collections.Concurrent;
using System.Threading;

namespace OpenMasu.Unity
{
    public sealed class OpenMasuDispatcher
    {
        private readonly ConcurrentQueue<Action> queue = new ConcurrentQueue<Action>();
        private readonly int capacity;
        private int count;
        private long dropped;

        public OpenMasuDispatcher(int capacity = 4096)
        {
            if (capacity < 1) throw new ArgumentOutOfRangeException(nameof(capacity));
            this.capacity = capacity;
        }

        public long DroppedCount => Interlocked.Read(ref dropped);

        public bool Post(Action action)
        {
            if (action == null) throw new ArgumentNullException(nameof(action));
            if (Interlocked.Increment(ref count) > capacity)
            {
                Interlocked.Decrement(ref count);
                Interlocked.Increment(ref dropped);
                return false;
            }
            queue.Enqueue(action);
            return true;
        }

        public int Pump()
        {
            var processed = 0;
            while (queue.TryDequeue(out var action))
            {
                Interlocked.Decrement(ref count);
                action();
                processed++;
            }
            return processed;
        }
    }
}
