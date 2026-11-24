export type ApiEndpoint = {
  method: 'GET' | 'POST' | 'DELETE' | 'PUT' | 'HEAD' | 'PROPFIND' | 'MKCOL';
  path: string;
  description: string;
  server: 'admin' | 'client' | 'metrics';
  exampleBody?: string;
  requiresAuth?: boolean;
};

export type EndpointGroup = {
  server: 'admin' | 'client' | 'metrics';
  name: string;
  description: string;
  baseUrl: string;
  endpoints: ApiEndpoint[];
};
