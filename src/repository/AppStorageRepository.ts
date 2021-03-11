import { EntityRepository, Repository } from 'typeorm';
import { AppStorage } from '../entity/AppStorage';

@EntityRepository(AppStorage)
export class AppStorageRepository extends Repository<AppStorage> {
    async getByKey<T = string>(key: string, unserialize = false): Promise<T | undefined> {
        const rawValue = (await this.findOne({
            where: { key: key },
        }))?.value;
        if (typeof rawValue !== 'undefined' && unserialize) {
            return JSON.parse(rawValue) as T;
        }
        return rawValue as any;
    }

    async setByKey(key: string, value: string | any) {
        if (typeof value !== 'string') {
            value = JSON.stringify(value);
        }
        const updateResult = await this.update({ key }, { value });
        if (updateResult.affected === 1) return;
        await this.insert({ key, value });
    }
}
