import {fieldError, fieldTransaction, openFieldDatabase} from './field-db.js';
import {openFieldValue, sealFieldValue, verifyFieldKey} from './field-security.js';

const DATABASE = 'quiet-maps-forestry';
const RECORDS = 'records';

export async function openForestryStore(key) {
  const fieldId = await verifyFieldKey(key);
  const db = await openFieldDatabase(DATABASE,1,opened => opened.createObjectStore(RECORDS,{keyPath:'id'}));
  const transact = (mode,work) => fieldTransaction(db,[RECORDS],mode,work);
  const binding = id => [fieldId,'forestry',id];
  return {
    close() { db.close(); },
    async list() {
      const rows = await transact('readonly',([table],read,done) => read(table.getAll(),done));
      const result = [];
      for (const row of rows) {
        try {
          const value = await openFieldValue(key,binding(row.id),row);
          result.push({id:row.id,value});
        } catch (error) {
          if (error.code !== 'field-corrupt') throw error;
          result.push({id:row.id,damaged:true});
        }
      }
      return result;
    },
    async add(value,knownIds) {
      const id = crypto.randomUUID();
      const record = await sealFieldValue(key,binding(id),value);
      const expected = new Set(knownIds);
      await transact('readwrite',([table],read) => read(table.getAllKeys(),current => {
        if (current.length !== expected.size || current.some(key => !expected.has(key))) {
          throw fieldError('changed');
        }
        table.add({id,...record});
      }));
      return {id,value};
    },
    remove(id) { return transact('readwrite',([table]) => table.delete(id)); },
  };
}
