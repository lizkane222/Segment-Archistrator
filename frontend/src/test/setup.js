import { POLICY, setCodeTrustPolicy } from '../functions/trust.js'

/* Most suites run function code to see what it does, which is exactly what the trust gate
   refuses by default. The gate has its own tests (functions/trust.test.js), which turn it back
   on. */
setCodeTrustPolicy(POLICY.allowAll)
