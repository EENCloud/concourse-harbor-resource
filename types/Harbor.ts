export interface IHarborChartYaml {
  apiVersion: string;
  description: string;
  home: string;
  icon: string;
  name: string;
  version: string;
  appVersion: string;
  maintainers: IHarborChartMaintainer[];
}

export interface IHarborChartMaintainer {
  name: string;
  email: string;
}
