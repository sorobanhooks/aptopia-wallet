import { StellarService } from './stellar-service';
import { IChainService } from './types';

export class ChainFactory {
  private static services: Map<string, IChainService> = new Map();

  static getService(chain: string): IChainService {
    const chainName = chain.toLowerCase();
    
    if (this.services.has(chainName)) {
      return this.services.get(chainName)!;
    }

    let service: IChainService;
    switch (chainName) {
      case 'stellar':
        service = new StellarService();
        break;
      // Future chains can be added here
      default:
        throw new Error(`Unsupported chain: ${chain}`);
    }

    this.services.set(chainName, service);
    return service;
  }
}
