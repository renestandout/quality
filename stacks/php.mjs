import laravel from './laravel.mjs'

/** @import { Stack, StackContext } from '../lib/types.mjs' */

// PHP ohne Laravel: identische Werkzeuge, nur ohne artisan-Testlauf.
/** @satisfies {Stack} */
export default {
  ...laravel,
  name: 'php',
  /** @param {StackContext} ctx */
  test(ctx) {
    return laravel.test({ ...ctx, dir: ctx.dir })
  },
}
