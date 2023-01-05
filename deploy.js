#!/usr/bin/env node

const themeKit = require("@shopify/themekit");
const { program } = require("commander");
const inquirer = require("inquirer");
const chalk = require("chalk");
const { parse } = require("yaml");
const https = require("https");
const fs = require("fs");

program
  .option("-e, --env <shop>", "默认配置文件首个商店")
  .option("-c, --config <file>", "默认: ./config.yml")
  .option("-y, --yes", "自动上传模式")

program.parse();
const options = program.opts();
const api = "admin/api/2022-10";
let config, env;

const request = (url, data) => {
  return new Promise((resolve, reject) => {
    const shops = url.match(/https:\/\/(.+)\.myshopify/);
    const token = config[shops[1]].password;
    const req = https.request(
      url,
      {
        method: data ? "post" : "get",
        headers: {
          "X-Shopify-Access-Token": token,
          "Content-Type": "application/json",
        },
      },
      (res) => {
        let str = "";
        res
          .on("data", (chunk) => {
            str += chunk;
          })
          .on("end", () => {
            try {
              const json = JSON.parse(str);
              resolve(json);
            } catch(e) {
              resolve(str);
            }
          });
      }
    );
    req.on("error", (err) => {
      reject(err);
    });
    if (data) {
      req.write(
        JSON.stringify(data)
      );
    }
    req.end();
  });
}

const upload = (shop, originalSource) => {
  const query = `mutation fileCreate($files: [FileCreateInput!]!) {
    fileCreate(files: $files) {
      files {
        createdAt
      }
      userErrors {
        field
        message
      }
    }
  }`;

  const variables = {
    files: {
      alt: "",
      contentType: "IMAGE",
      originalSource,
    },
  };
  return request(`https://${config[shop].store}/${api}/graphql.json`, {
    query,
    variables
  });
};

const uploadImgs = (shop, template) => {
  return new Promise((resolve, reject) => {
    fs.readFile(template, async (err, data) => {
      let { assets } = await request(`https://${config[env].store}/${api}/themes/${config[env].theme_id}/assets.json`);
      assets = assets.filter((item) => item.public_url);
      const baseURL = assets[0].public_url.match(/(https:\/\/cdn\.shopify.com\/s\/files\/\d+\/\d+\/\d+\/\d+)/)[1] + "/files";
      if (err) throw err;
      if (data) {
        let arr = [];
        const iteration = (obj) => {
          for (let key in obj) {
            if (typeof obj[key] === "object") {
              iteration(obj[key]);
            } else {
              if (
                typeof obj[key] === "string" &&
                obj[key].indexOf("shopify://shop_images") === 0
              ) {
                arr.push(obj[key]);
              }
            }
          }
        };
        iteration(JSON.parse(data));
        arr = arr.map(function (item) {
          return baseURL + item.replace("shopify://shop_images", "");
        });
        let promiseArr = [];
        for (let i = 0; i < arr.length; i++) {
          promiseArr.push(upload(shop, arr[i]));
        }
        Promise.all(promiseArr).then((results) => {
          if (results && results.length > 1 && results[0].errors) {
            console.log(chalk.bold.red(`${shop}图片上传失败`));
            console.log(chalk.red(results[0].errors[0].message));
          } else {
            console.log(chalk.green(`${shop}图片上传成功`));
          }
          resolve();
        });
      } else {
        resolve();
      }
    });
  });
};

const sync = (shop, template, flag) => {
  return new Promise(async (resolve, reject) => {
    if (flag) {
      try {
        const { store, theme_id, password } = config[shop];
        await themeKit.command("deploy", {
          store,
          themeId: theme_id,
          password,
          files: [template],
          allowLive: true,
        });
        console.log(chalk.green(`${shop}模板上传成功`));
      } catch(e) {
        console.log(chalk.bold.red(`${shop}模板上传失败`));
      }
    }
    let isUpload;
    if (options.yes) {
      isUpload = true;
    } else {
      const answer = await inquirer.prompt([
        {
          type: "confirm",
          name: "isUpload",
          message: `是否上传图片到${shop}?`,
          default: true,
        },
      ]);
      isUpload = answer.isUpload;
    }
    if (isUpload) {
      await uploadImgs(shop, template)
    }
    resolve();
  });
};

(async () => {
  const configFile = options.config || "./config.yml";
  if (!fs.existsSync(configFile)) {
    console.log(chalk.bold.red("配置文件不存在!"));
    return;
  }
  config = parse(fs.readFileSync(configFile, "utf8"));
  env = options.env || Object.keys(config)[0];
  const answers = await inquirer.prompt([
    {
      type: "input",
      name: "template",
      message: "请输入要同步的json模板文件",
    },
    {
      type: "checkbox",
      name: "shops",
      message: "请选择要同步的商店",
      choices: Object.keys(config),
    },
  ]);
  let { template, shops } = answers;
  if (template.indexOf(".json") < 0) {
    template += ".json";
  }
  template = "templates/" + template;
  const { store, theme_id, password } = config[env];
  try {
    await themeKit.command("download", {
      store,
      themeId: theme_id,
      password,
      files: [template],
    }, {logLevel: "silent"});
  } catch (e) {
    console.log(chalk.bold.red("错误：模板不存在!"));
    return;
  }
  for (let i = 0; i < shops.length; i++) {
    const data = await request(`https://${config[shops[i]].store}/${api}/themes/${config[shops[i]].theme_id}/assets.json?asset[key]=${template}`);
    if (data) {
      let overwrite;
      if (options.yes) {
        overwrite = true;
      } else {
        const answer = await inquirer.prompt([
          {
            type: "confirm",
            name: "overwrite",
            message: `${shops[i]}模板已存在，是否覆盖?`,
            default: false,
          },
        ]);
        overwrite = answer.overwrite;
      }
      await sync(shops[i], template, overwrite);
    } else {
      await sync(shops[i], template, true);
    }
  }
})();
