import { QmMonitor, Proxmox } from "proxmox-api";
import nodeUsb, { Device } from 'usb';

export interface HotPlugServiceOption {
    vmid?: number;
    node?: string;
    denyUsb?: Set<String>;
    // denyProduct?: Set<String>;
    forceUsb?: Set<String>;
    watch?: number;
    flush?: number;
    blockHub?: boolean;
}

export interface USBOverview {
    vendorId: string;
    productId: string;
    port: string;
    addr: number;
    bus: number;
    ancestor: string[];
}

const vendorFromDeviceSync = (device: Device): USBOverview => {
    const deviceDescriptor = device.deviceDescriptor;
    const vendorId = deviceDescriptor.idVendor.toString(16).padStart(4, '0');
    const productId = deviceDescriptor.idProduct.toString(16).padStart(4, '0');
    const port = device.portNumbers ? device.portNumbers.join('.') : '';
    const addr = device.deviceAddress;
    const bus = device.busNumber;
    const ancestor = [] as string[];
    let parent = device.parent
    while (parent) {
        const deviceDescriptor = parent.deviceDescriptor;
        const vendorId = deviceDescriptor.idVendor.toString(16).padStart(4, '0');
        const productId = deviceDescriptor.idProduct.toString(16).padStart(4, '0');
        ancestor.push(`${vendorId}:${productId}`);
        parent = parent.parent;
    }
    return { vendorId, productId, port, addr, bus, ancestor };
}

const vendorFromDevice = async (device: Device): Promise<USBOverview & { manufacturer: string, deviceName: string }> => {
    const overview = vendorFromDeviceSync(device)
    const getStringDescriptor = (id: number): Promise<string> => new Promise((resolve, reject) => device.getStringDescriptor(id, (error, text) => { if (error) resolve(`${id}`); else resolve(text || '') }));
    const deviceDescriptor = device.deviceDescriptor;
    const manufacturer = await getStringDescriptor(deviceDescriptor.iManufacturer);
    const deviceName = await getStringDescriptor(deviceDescriptor.iProduct);
    return { ...overview, manufacturer, deviceName };
}

const delay = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

export default class HotPlugService {
    private qmMonitor?: QmMonitor;
    private options: HotPlugServiceOption;

    constructor(private proxmox: Proxmox.Api, options?: HotPlugServiceOption) {
        this.options = options || {};
        this.postInit();
    }

    async postInit() {
        if (this.options.flush)
             await this.detachAll();
        await this.attacheForced()
        if (this.options.watch)
            this.watch(this.options.watch);
    }

    async watch(interval: number) {
        while (true) {
            const qmMonitor = await this.getQmMonitor();
            if (!qmMonitor)
                return;
            let devices = await qmMonitor.infoUsb();
            for (const device of devices) {
                // if (!device.product && !device.id) {
                //     console.log(`remove ${device.id}`);
                //     await qmMonitor.deviceDel(device.id);
                // }
                //if (this.options.denyProduct && this.options.denyProduct.has(device.product)) {
                //    await qmMonitor.deviceDel(device.id);
                //    console.log(`remove ${device.id}`);
                //    continue;
                //}
                //if (this.options.denyUsb && this.options.denyProduct.has(device.product)) {
                //    await qmMonitor.deviceDel(device.id);
                //    continue;
                //}
            }
            console.log(devices);
            if (!interval)
                return;
            await delay(interval * 1000);
        }
    }

    async findPassthroughVmid(): Promise<number> {
        let nodes = await this.proxmox.nodes.$get();
        if (this.options.node)
            nodes = nodes.filter(n => n.node === node);
        if (!nodes.length)
            throw Error(`missng node ${this.options.node}`);
        const node = nodes[0].node;
        const vms = await this.proxmox.nodes.$(node).qemu.$get();
        for (const vm of vms) {
            if (vm.status != 'running') {
                continue;
            }
            const config = await this.proxmox.nodes.$(node).qemu.$(vm.vmid).config.$get();
            if (config.hostpci0) {
                console.log(`Using ${vm.vmid} as Passthrough vmid`)
                return vm.vmid;
            }
        }
        return 0;
    }

    private async getQmMonitor(): Promise<QmMonitor | null> {
        if (!this.options.vmid) {
            // MODE AUTODETECT
            if (this.qmMonitor) {
                const info = await this.qmMonitor.info('status');
                // the VM is off
                if (!~info.includes('running'))
                    this.qmMonitor = undefined;
            }
        }

        if (!this.qmMonitor) {
            const nodes = await this.proxmox.nodes.$get();
            // this.node = nodes[0].node;
            let vmid = this.options.vmid;
            if (!vmid) {
                vmid = await this.findPassthroughVmid();
            }
            if (!vmid) {
                console.log('NO Passthrough currently running');
                return null;
            }
            this.qmMonitor = new QmMonitor(this.proxmox, nodes[0].node, vmid);
        }
        return this.qmMonitor;
    }

    //private key(usb: USBHostInfo): string {
    //    return `${usb.class},${usb.addr},${usb.bus},${usb.port},${usb.vendorId}:${usb.productId}`
    //}

    //private indexUsb(usbs: USBHostInfo[]) {
    //    this.usbIndex.clear()
    //    for (const usb of usbs) {
    //        this.usbIndex.add(this.key(usb));
    //    }
    //}

    private async detachAll() {
        const qmMonitor = await this.getQmMonitor();
        if (qmMonitor) {
            const devices = await qmMonitor.infoUsb();
            for (const device of devices)
                await qmMonitor.deviceDel(device.id)
        }
    }

    private async attacheForced() {
        const forceUsb = this.options.forceUsb;
        //if (forceUsb && forceUsb.size) {
        const qmMonitor = await this.getQmMonitor();
        if (qmMonitor) {
            let devices: Device[] = nodeUsb.getDeviceList()
            for (const device of devices) {
                const info = vendorFromDeviceSync(device);
                if (this.options.blockHub) {
                    for (const parent of info.ancestor) {
                        if (!this.options.denyUsb)
                            this.options.denyUsb = new Set();
                        this.options.denyUsb.add(parent);
                    }
                }
                const { vendorId, productId, bus, port } = info;
                if (forceUsb && forceUsb.has(`${vendorId}:${productId}`)) {
                    const key = `B${bus}P${port}`;
                    const ret = await qmMonitor.deviceAddByPort(key, { bus, port });
                } else {
                }
            }
        }
    }

    /**
     * faster but do not support multiple identical USB devices
     */
    // public async hotPlugByVendor(): Promise<any> {
    //     // usbDetect.startMonitoring();
    // 
    //     // usbDetect 'add'
    //     nodeUsb.on('attach', async (device: Device) => {
    //         const { vendorId, productId, manufacturer, deviceName } = await vendorFromDevice(device);
    //         if (this.options.denyUsb && this.options.denyUsb.has(`${vendorId}:${productId}`)) {
    //             console.log(`ignoring ${manufacturer}(${deviceName})[${vendorId}:${productId}]`);
    //             return;
    //         }
    // 
    //         const qmMonitor = await this.getQmMonitor();
    //         if (qmMonitor) {
    //             const key = `V${vendorId}P${productId}`;
    //             const ret = await qmMonitor.deviceAddById(key, { vendorId, productId });
    //             console.log(`Add USB: ${manufacturer}(${deviceName})[${vendorId}:${productId}] with Key:${key} ret:${ret}`);
    //         } else {
    //             console.log(`new USB Device, but no Passthrough detected: ${manufacturer}(${deviceName})[${vendorId}:${productId}]`);
    //         }
    //     });
    // 
    //     // usbDetect 'remove'
    //     nodeUsb.on('detach', async (device: Device) => {
    //         const { vendorId, productId, manufacturer, deviceName, addr, port } = await vendorFromDevice(device);
    //         const qmMonitor = await this.getQmMonitor();
    //         let lastRet = '';
    //         if (qmMonitor) {
    //             const key = `V${vendorId}P${productId}`;
    //             lastRet = await qmMonitor.deviceDel(key);
    //             if (lastRet) {
    //                 const key2 = `B${addr}P${port}`;
    //                 lastRet = await qmMonitor.deviceDel(key2);
    //             }
    //         }
    //         console.log(`remove USB: ${manufacturer}(${deviceName})[${vendorId}:${productId}] ${lastRet.trim()}`);
    //     });
    // }

    /**
     * slower, but support multiple identical USB devices
     */
    public async hotPlugByPort(): Promise<any> {
        //usbDetect.startMonitoring();
        //{
        //const qmMonitor = await this.getQmMonitor();
        //if (qmMonitor)
        //    this.indexUsb(await qmMonitor.infoUsbhost())
        //}
        // usbDetect 'add'
        nodeUsb.on('attach', async (device: Device) => {
            const { vendorId, productId, manufacturer, deviceName, port, addr, bus } = await vendorFromDevice(device);
            if (this.options.denyUsb && this.options.denyUsb.has(`${vendorId}:${productId}`)) {
                console.log(`ignoring ${manufacturer}(${deviceName})[${vendorId}:${productId}]`);
                return;
            }
            const qmMonitor = await this.getQmMonitor();
            if (!qmMonitor) {
                console.log(`new USB Device, but no Passthrough detected: ${manufacturer}(${deviceName})[${vendorId}:${productId}]`);
                return;
            }
            const key = `B${bus}P${port}`;
            console.log(device);
            const ret = await qmMonitor.deviceAddByPort(key, { bus, port });
            console.log(`Add USB: ${manufacturer}(${deviceName})[${vendorId}:${productId}] with Key:${key} ret:${ret}`);
        });

        // usbDetect 'remove'
        nodeUsb.on('detach', async (device: Device) => {
            const { vendorId, productId, manufacturer, deviceName, port, bus } = await vendorFromDevice(device);
            const qmMonitor = await this.getQmMonitor();
            let action = '';
            if (qmMonitor) {
                const key = `B${bus}P${port}`;
                const ret = await qmMonitor.deviceDel(key);
                action = ` unplug ${key} from vm ${ret.trim()}`;
            }
            console.log(`remove USB: ${manufacturer}(${deviceName})[${vendorId}:${productId}]${action}`);
        });
    }
}
