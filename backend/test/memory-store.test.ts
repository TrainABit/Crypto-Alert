import { MemoryStore } from '../src/store/memory.ts';
import { storeContract } from './store-contract.ts';

storeContract('MemoryStore', async () => new MemoryStore());
