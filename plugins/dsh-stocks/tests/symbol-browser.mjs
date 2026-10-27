async page => {
 await page.reload();
 await page.getByRole('button',{name:'MoYu',exact:true}).click();
 await page.getByRole('button',{name:'Open a stock',exact:true}).click();
 await page.getByRole('textbox',{name:'Search stocks',exact:true}).fill('MRNA');
 await page.getByRole('button',{name:'Open',exact:true}).click();
 await page.getByRole('heading',{name:'MRNA',exact:true}).waitFor();
 const summary=page.locator('#stocks-page iframe[title="MRNA"]');
 const profile=page.locator('#stocks-page iframe[title="Profile MRNA"]');
 await summary.contentFrame().getByText(/Moderna/i).first().waitFor({timeout:20000});
 const body=await summary.contentFrame().locator('body').innerText();
 if(/APPLE INC|Apple Inc/.test(body))throw new Error('Apple fallback remains');
 await profile.contentFrame().getByText(/Moderna/i).first().waitFor({timeout:20000});
 return {summary:body.slice(0,350),summaryUrl:await summary.getAttribute('src'),profile:await profile.contentFrame().locator('body').innerText()};
}
