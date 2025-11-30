// env.ts - RiderCMS Sandbox Environment Configuration
export const ENV = {
  // M-Pesa Sandbox credentials
  MPESA_CONSUMER_KEY: "yhAQOrn9eNRJsBJ8NDsQz0I4Nu2XxDZ182e2YYMDFY7PVobo",
  MPESA_CONSUMER_SECRET: "HKqljggp7UzwhZxm1op4XqJEFAVhYGHqjUgBiCmsrFiI15oR1JmUUauppGi1cXY5",
  MPESA_SHORTCODE: "174379", // default sandbox shortcode
  MPESA_PASSKEY: "bfb279f9aa9bdbcf158e97dd71a467cd2e0c893059b10f78e6b72ada1ed2c919", // replace with actual sandbox passkey from Safaricom portal
  CALLBACK_URL: "https://mydomain.com/mpesa-express-simulate/", // deployed Cloud Run endpoint

  // Firebase service account info
  FIREBASE_PROJECT_ID: "ridercms-ced94",
  FIREBASE_CLIENT_EMAIL: "firebase-adminsdk-fbsvc@ridercms-ced94.iam.gserviceaccount.com", // e.g., ridercms-ced94@ridercms-ced94.iam.gserviceaccount.com
  FIREBASE_PRIVATE_KEY: `-----BEGIN PRIVATE KEY-----\nMIIEvgIBADANBgkqhkiG9w0BAQEFAASCBKgwggSkAgEAAoIBAQD4zC1Y4iV/CzvB\n1vI2CFq4SHa++vx02b/jvE2hkHMuSZG7n4TKxIjjv2Xs9sZGCT5xRsmd5rTi09Gj\nE5OFCsn7bXks7fTB7GyxsVNSU9jIMBsmvacOYzMuu4N5+gVCb3wN1HKWspp0wtdl\njGk7TvRSXTcnwLbIkJ9L5JvSRn6z2Iti73E5oOG/mZF9IkA/6L68/IGRiyvnU/6u\nSXDNq2kkpK99n8W/TKjHXH/ZRlCIz77yx8SijgrOYGt+f0ZH70J7YkAvTKphqfUQ\neXOPbOShI6ZNmY1YcnGwi7gzxbzO+qr/auQ6Y/ngR+dpshlIeORivRlbDxaEWlwm\nMvfKG8LFAgMBAAECggEAJ0qnhrgAT/YIM+6sRdg/64aWKkcdA5837NFaOT/E0PSR\nbV4d7J/pNn6NrES0v27KS71wLd23h3MIUobO713q1ChP0MartsyNxepJTGEthUAD\nqbSd42nLNYArnWHc3scYgl6g0ifWuMXkmob4P4OSlkdeZIrM0xPz9FpgOW8kp2Yl\ntbQXzZ/37i5hoCmcI++C1cNlpZmT4Zz7DExrBcayhFvzvzt1vFyzrtmAVyjNnUCC\nfibxJB/rqI7emkSIp3aMZstLuMdN92iJ1QnMHp6L7fifYSUoVoZmcKasWO13zSpE\n2+8YoYe+iM7VBth5KePfgp1swzR8lWb98aUxa/nKgQKBgQD+kznHKQIt03DhP498\nkyjIN+WeKpSTEm+cifNbBRydP4t8BaZtUzcZcEUXu4uTn1CQHeOvPSLjHFmCna9U\nhC7jS67g7ibaA1lxncL8MNgSmBv+fGF/hjXS2mPPXop9a5GJtnpxJBtTuNko4y4Z\noUkK7o0/BjcX+oLULPVMhFAYlQKBgQD6MKxHCSfj50D7eAO+PpeHLxt0OLq0DzG8\nY/dR7rR7+hxp9CjpBfhfUTmPYLsp/S6nhMQLn908KeBYTYQivRfJQ2WLk5Yjgete\ndMAI2KdCN52cZVCNwUA1MfEsK2kJma0MwBw3HZiKCs5SWHkEMfhcSUZHDD4NoQ2d\n0q0+aa4FcQKBgQDRie8ZvehcPdiAnqeFGz+LJW8rc9LdB2S0zVtwRNHboK03xRLK\nk58boixMr4LgXFaceO2qlMC9fN00RIRHJZHOZsInw/5Ynj8l5HvUxoNjMq6AFnLN\n23M7/aP/0MpfF4YwevFnZRfVHqYoIG4WjImppNa/1GbOptS+vc6eT535zQKBgDCk\nofo1t4HCBopd7Sxh8wgfipDwLqyvf5YHQaC2bnTkTf3zsLiNppqxqiVMQ1eImDeN\nwqgX7uWxpqLEf3pZlXRWHDok+b3xlpeIz4Voyiw/r+8ma6ED/73X9fIGhqeNL24Z\nM+MrZ+r+6tprxSuho44d2QIbST1RINqciX5nAaShAoGBAO04WvqSym7m8d4WQHYH\nz0GMggIyQbWtZh6rm9NWuPqJYWWzSZ39bY/ZNPjyoUdFpKoKPBl6M9UvrFnfTjCd\nj8WeKwvyuYQAWJOfOoLMkYItuF6Omvdferl0uQbgMgP7brni66N3S/b4NtSnbeuo\niUAxKZG6kpiEdE5f82IOR5lZ\n-----END PRIVATE KEY-----\n`
};
